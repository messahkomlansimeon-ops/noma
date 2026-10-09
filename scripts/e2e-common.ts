/**
 * Éléments communs aux essais de bout en bout (`e2e:core`, `e2e:ui`) : tout passe par le RELAIS de développement
 * (scripts/dev-proxy.ts, port 3212 par défaut). Les scripts n'envoient JAMAIS eux-mêmes X-Noma-Proxy-Secret ni
 * X-Forwarded-For : c'est le relais qui les écrit, comme le ferait un reverse proxy de confiance.
 *
 * Variables :
 *   NOMA_E2E_BASE_URL           origine du RELAIS (défaut http://localhost:3212) ; DOIT être NOMA_AUTH_ORIGIN du serveur
 *   NOMA_E2E_SERVER_LOG         fichier où la sortie du serveur est enregistrée (les lignes `[auth:dev]` y sont lues)
 *   NOMA_E2E_DATABASE_URL       base du serveur testé (pour la commande d'administration boost:grant) ; DOIT se terminer par /noma_e2e
 *   NOMA_E2E_MENO_CAPTURE       fichier (une ligne JSON {at,to,content} par SMS accepté) du FAUX serveur Meno de l'essai (scripts/e2e-fake-meno.ts), quand le serveur a été lancé avec
 *                               NOMA_SMS_PROVIDER=meno vers ce faux serveur (lot SMS1) : les codes OTP sont alors lus dans ce fichier, et non dans la sortie du serveur
 *   NOMA_E2E_NOTIFY_CONSOLE     « 1 » quand le serveur a été lancé avec NOMA_DEV_NOTIFY_CONSOLE=1 (transport de notification de développement : les lignes
 *                               `[notify:dev]` du journal sont alors vérifiées ; sans cela, aucun envoi simulé n'est attendu)
 * Les codes OTP lus dans le journal ne sont jamais affichés.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createApiClient, type ApiClient } from "../lib/client/api";

export const E2E_BASE = (process.env.NOMA_E2E_BASE_URL ?? "http://localhost:3212").replace(/\/$/, "");
export const E2E_SERVER_LOG = process.env.NOMA_E2E_SERVER_LOG ?? "";

const OTP_LINE = /\[auth:dev\] code OTP pour \+\*+([0-9]{2}) : ([0-9]{6}) \(expire à [0-9]{2}:[0-9]{2}:[0-9]{2} UTC\)/;

export function logSize(): number {
  return statSync(E2E_SERVER_LOG).size;
}

/** Lot SMS1 : fichier des SMS reçus par le faux serveur Meno (vide : le serveur est lancé avec le transport console de développement). */
const MENO_CAPTURE = process.env.NOMA_E2E_MENO_CAPTURE ?? "";
export const E2E_MENO_MODE = MENO_CAPTURE !== "";

/** Taille de la source des codes OTP (journal du serveur, ou fichier du faux serveur Meno) : à lire AVANT la demande de code, puis à passer à `awaitOtpLine`. */
export function otpSourceSize(): number {
  return statSync(MENO_CAPTURE || E2E_SERVER_LOG).size;
}

export interface MenoCapturedMessage {
  at: string;
  to: string;
  content: string;
}

/** SMS acceptés par le faux serveur Meno après `offset` octets de son fichier. */
export function menoMessagesSince(offset: number): MenoCapturedMessage[] {
  if (!E2E_MENO_MODE) return [];
  return readFileSync(MENO_CAPTURE)
    .subarray(offset)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as MenoCapturedMessage);
}

/** Attend, après `offset` octets du journal du serveur (ou du fichier du faux serveur Meno), le code de connexion et renvoie le code et les deux derniers chiffres du numéro. */
export async function awaitOtpLine(offset: number): Promise<{ code: string; tail: string }> {
  if (E2E_MENO_MODE) {
    const limit = Date.now() + 15_000;
    while (Date.now() < limit) {
      for (const message of menoMessagesSince(offset)) {
        const match = /^noma : votre code est ([0-9]{6})\. /.exec(message.content);
        if (match) return { code: match[1], tail: message.to.slice(-2) };
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("aucun SMS de code dans le fichier du faux serveur Meno (NOMA_SMS_PROVIDER=meno vers le faux serveur ?)");
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const text = readFileSync(E2E_SERVER_LOG).subarray(offset).toString("utf8");
    const match = OTP_LINE.exec(text);
    if (match) return { tail: match[1], code: match[2] };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("aucune ligne [auth:dev] dans la sortie du serveur (NODE_ENV=development et NOMA_DEV_OTP_CONSOLE=1 ?)");
}

/**
 * Lot T3 : attend un ÉTAT STABLE avant de s'en servir comme point de départ d'une vérification. Un état est stable quand le système est au repos (`quiet`) avant ET après deux lectures
 * identiques (`read`, comparées en JSON) séparées de `gapMs`. Rend la seconde lecture. Un worker qui écrit encore, de façon asynchrone, ne fait ainsi jamais varier ce qu'on mesure.
 */
export async function waitForSettledValue<T>(options: {
  label: string;
  read: () => Promise<T>;
  quiet: () => Promise<boolean>;
  timeoutMs: number;
  gapMs?: number;
  hint?: string;
}): Promise<T> {
  const gap = options.gapMs ?? 2_000;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (await options.quiet()) {
      const first = await options.read();
      await pause(gap);
      const second = await options.read();
      if (JSON.stringify(first) === JSON.stringify(second) && (await options.quiet())) return second;
    } else {
      await pause(gap);
    }
  }
  throw new Error(`${options.label} : délai de ${options.timeoutMs} ms dépassé${options.hint ? ` — ${options.hint}` : ""}`);
}

/** Numéro ivoirien canonique à 10 chiffres locaux : « 07 » + 6 chiffres issus de l'horloge + les deux chiffres demandés. */
export function uniquePhone(lastTwoDigits: string): string {
  const middle = `${Date.now() % 1_000_000}`.padStart(6, "0");
  return `+22507${middle}${lastTwoDigits}`;
}

export async function pollUntil<T>(
  label: string,
  produce: () => Promise<T | null>,
  timeoutMs: number,
  hint = "le worker de matching tourne-t-il sur la même base ?",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await produce();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label} : délai de ${timeoutMs} ms dépassé — ${hint}`);
}

/**
 * Attente BORNÉE d'une VALEUR (jamais « l'élément est apparu, donc sa valeur est la bonne ») : un compteur qui se met à jour de façon asynchrone (lecture réseau, flux en direct,
 * magasin partagé) ne se lit pas une fois pour toutes. `read` ne doit pas attendre longtemps (utiliser `{ timeout }` ou une lecture atomique) ; une lecture qui échoue compte comme
 * « non lisible ». L'échec nomme la valeur attendue et la dernière valeur OBSERVÉE.
 */
export async function waitForValue<T>(
  label: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  expectedLabel: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let observed = "(aucune lecture)";
  for (;;) {
    try {
      const value = await read();
      if (accept(value)) return value;
      observed = JSON.stringify(value);
    } catch (error) {
      observed = `(illisible : ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} : valeur attendue ${expectedLabel}, observée ${observed} après ${timeoutMs} ms`);
}

/** Un « navigateur » : jar de cookies et en-tête Origin ; AUCUN en-tête du proxy de confiance (le relais les écrit). */
export class RelaySession {
  readonly cookies = new Map<string, string>();

  constructor(
    readonly label: string,
    private readonly base: string = E2E_BASE,
  ) {}

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map((part) => part.trim());
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute) || /^expires=.*1970/i.test(attribute));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async fetch(path: string, init: RequestInit & { origin?: string | null; noCookies?: boolean } = {}): Promise<Response> {
    const { origin = this.base, noCookies = false, headers: given, signal: callerSignal, ...rest } = init;
    const headers: Record<string, string> = { ...((given as Record<string, string> | undefined) ?? {}) };
    if (origin !== null) headers.origin = origin;
    const cookie = this.cookieHeader();
    if (cookie && !noCookies) headers.cookie = cookie;
    const response = await fetch(`${this.base}${path}`, {
      ...rest,
      headers,
      redirect: "manual",
      // Le signal de l'appelant COMPTE (lot D3) : avant, il était remplacé par le délai de 120 s, si bien qu'un flux « abandonné » par `controller.abort()` n'était jamais fermé
      // (c'est ce qui faisait croire à une fuite de places dans le flux en direct). Le délai et l'abandon de l'appelant s'additionnent.
      signal: callerSignal ? AbortSignal.any([AbortSignal.timeout(120_000), callerSignal]) : AbortSignal.timeout(120_000),
    });
    this.absorb(response);
    return response;
  }

  client(): ApiClient {
    return createApiClient({ fetch: (input, init) => this.fetch(String(input), init as RequestInit) });
  }
}

/** Connexion par OTP (demande, lecture du code dans le journal du serveur, vérification) ; renvoie l'identifiant du compte. */
export async function loginWithOtp(session: RelaySession, phone: string): Promise<string> {
  const api = session.client();
  const offset = otpSourceSize();
  const challenge = await api.auth.requestOtp(phone);
  const { code, tail } = await awaitOtpLine(offset);
  assert.equal(tail, phone.slice(-2), "la ligne de code vise bien ce téléphone (deux derniers chiffres)");
  const { userId } = await api.auth.verifyOtp(challenge.challengeId, code);
  assert.ok(session.cookies.has("noma_auth"), "le cookie noma_auth est posé");
  return userId;
}

/** Base de l'essai : refus de toute base qui n'est pas explicitement `noma_e2e` (jamais noma_dev). */
export function e2eDatabaseUrl(): string {
  const url = process.env.NOMA_E2E_DATABASE_URL ?? "";
  if (!url) throw new Error("NOMA_E2E_DATABASE_URL est requis (base du serveur testé, noma_e2e).");
  if (!/\/noma_e2e(\?.*)?$/.test(url)) throw new Error("NOMA_E2E_DATABASE_URL doit désigner la base noma_e2e : refus de toute autre base.");
  return url;
}

/**
 * COMMANDE D'ADMINISTRATION `boost:grant` (aucun paiement) sur la base noma_e2e : attribue un boost à une offre.
 * Renvoie la ligne affichée par la commande (sans secret). Lève une erreur si la commande refuse.
 */
export function grantBoostByAdministration(offerId: string, duration: "24h" | "3d" | "7d"): Promise<string> {
  const databaseUrl = e2eDatabaseUrl();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, NODE_OPTIONS: "--conditions=react-server" };
    const child = spawn(
      process.execPath,
      ["--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/boost-grant.ts", "--offer", offerId, "--duration", duration],
      { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => reject(new Error("boost:grant : lancement impossible")));
    child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`boost:grant a refusé (code ${code}) : ${out.trim().slice(0, 200)}`))));
  });
}

/**
 * COMMANDE D'ADMINISTRATION `boost:refund-purchase` sur la base noma_e2e : rembourse INTÉGRALEMENT un achat de boost (le boost actif est annulé, le crédit est
 * rendu). Renvoie la ligne affichée ; lève une erreur si la commande refuse.
 */
export function refundPurchaseByAdministration(purchaseId: string, reasonCode: string): Promise<string> {
  const databaseUrl = e2eDatabaseUrl();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, NODE_OPTIONS: "--conditions=react-server" };
    const child = spawn(
      process.execPath,
      ["--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/boost-refund-purchase.ts", "--purchase", purchaseId, "--reason", reasonCode],
      { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => reject(new Error("boost:refund-purchase : lancement impossible")));
    child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`boost:refund-purchase a refusé (code ${code}) : ${out.trim().slice(0, 200)}`))));
  });
}

/**
 * COMMANDE `dev:seed` (annonces concurrentes d'exemple, vendeurs fictifs +225 07 99 99 99 xx) sur la base noma_e2e. NODE_ENV vaut « development »
 * pour l'enfant (la commande refuse tout autre NODE_ENV). Renvoie la sortie ; lève une erreur si refus.
 */
export function seedExamplesByAdministration(options: { category: string; brand: string; model: string; offers: number }): Promise<string> {
  const databaseUrl = e2eDatabaseUrl();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", DATABASE_URL: databaseUrl, NODE_OPTIONS: "--conditions=react-server" };
    const child = spawn(
      process.execPath,
      [
        "--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/dev-seed.ts",
        "--category", options.category, "--brand", options.brand, "--model", options.model, "--offers", String(options.offers),
      ],
      { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => reject(new Error("dev:seed : lancement impossible")));
    child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`dev:seed a refusé ou échoué (code ${code}) : ${out.trim().slice(0, 300)}`))));
  });
}

/**
 * COMMANDE `demo:seed` (marché de démonstration, lot D1) sur la base noma_e2e. NODE_ENV vaut « development » pour l'enfant (la commande refuse tout autre NODE_ENV).
 * Renvoie la sortie ; lève une erreur si refus ou échec.
 */
export function demoSeedByAdministration(): Promise<string> {
  const databaseUrl = e2eDatabaseUrl();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", DATABASE_URL: databaseUrl, NODE_OPTIONS: "--conditions=react-server" };
    const child = spawn(process.execPath, ["--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/demo-seed.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => reject(new Error("demo:seed : lancement impossible")));
    child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`demo:seed a refusé ou échoué (code ${code}) : ${out.trim().slice(0, 300)}`))));
  });
}

/**
 * COMMANDE `active-search:simulate` (lot RA1) sur la base noma_e2e : fait apparaître une annonce FICTIVE compatible d'un autre site pour ce besoin, collecte sa surveillance (connecteurs
 * FICTIFS) et passe l'étape « activeSearch » du worker. Renvoie sa sortie ; lève une erreur si elle refuse ou échoue.
 */
export function activeSearchSimulateByAdministration(demandId: string): Promise<string> {
  const databaseUrl = e2eDatabaseUrl();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", DATABASE_URL: databaseUrl, NODE_OPTIONS: "--conditions=react-server" };
    const child = spawn(process.execPath, ["--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/active-search-simulate.ts", "--demand", demandId], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => reject(new Error("active-search:simulate : lancement impossible")));
    child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`active-search:simulate a refusé ou échoué (code ${code}) : ${out.trim().slice(0, 300)}`))));
  });
}

/**
 * COMMANDE D'ADMINISTRATION `wallet:check` (lecture seule) sur la base noma_e2e : réconciliation du grand livre, des intentions de
 * recharge, des événements et des achats de boost. Renvoie sa sortie ; lève une erreur si elle signale un écart (code 1) ou échoue.
 */
export function walletCheckByAdministration(): Promise<string> {
  const databaseUrl = e2eDatabaseUrl();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, NODE_OPTIONS: "--conditions=react-server" };
    const child = spawn(process.execPath, ["--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/wallet-check.ts"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => reject(new Error("wallet:check : lancement impossible")));
    child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`wallet:check a signalé un écart ou échoué (code ${code}) : ${out.trim().slice(0, 600)}`))));
  });
}

/** Ligne du transport de notification de développement (le worker de dev:full préfixe ses lignes par `[matching] `). */
const NOTIFY_LINE = /\[notify:dev\] envoi simulé à ([0-9a-f]{1,8})… : (\d+) annonces?, lien (\S+)/g;

export interface NotifyConsoleLine {
  /** Identifiant tronqué (8 caractères hexadécimaux au plus), jamais l'identifiant entier. */
  user: string;
  count: number;
  link: string;
}

/** Lignes `[notify:dev]` écrites dans le journal du serveur après `offset` octets. */
export function notifyConsoleLinesSince(offset: number): NotifyConsoleLine[] {
  const text = readFileSync(E2E_SERVER_LOG).subarray(offset).toString("utf8");
  return [...text.matchAll(NOTIFY_LINE)].map((match) => ({ user: match[1], count: Number(match[2]), link: match[3] }));
}

/** Vrai quand les heures calmes (22 h – 7 h UTC) sont en cours : aucun envoi externe n'est alors permis. */
export function isQuietHourNow(now: Date = new Date()): boolean {
  const hour = now.getUTCHours();
  return hour >= 22 || hour < 7;
}

/**
 * COMMANDE D'ADMINISTRATION `notifications:purge` (SIMULATION seulement, jamais --apply) sur la base noma_e2e. Renvoie sa sortie ; lève une erreur si elle échoue.
 */
export function notificationsPurgeSimulationByAdministration(): Promise<string> {
  const databaseUrl = e2eDatabaseUrl();
  return new Promise((resolve, reject) => {
    // NODE_ENV absent : la commande s'exécute (absent, development ou test seulement), jamais hérité d'un environnement de production.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_ENV"));
    const env = { ...inherited, DATABASE_URL: databaseUrl, NODE_OPTIONS: "--conditions=react-server" } as unknown as NodeJS.ProcessEnv;
    const child = spawn(process.execPath, ["--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/notifications-purge.ts"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => reject(new Error("notifications:purge : lancement impossible")));
    child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`notifications:purge a échoué (code ${code}) : ${out.trim().slice(0, 300)}`))));
  });
}
