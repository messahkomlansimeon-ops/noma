/**
 * Éléments communs aux essais de bout en bout (`e2e:core`, `e2e:ui`) : tout passe par le RELAIS de développement
 * (scripts/dev-proxy.ts, port 3212 par défaut). Les scripts n'envoient JAMAIS eux-mêmes X-Noma-Proxy-Secret ni
 * X-Forwarded-For : c'est le relais qui les écrit, comme le ferait un reverse proxy de confiance.
 *
 * Variables :
 *   NOMA_E2E_BASE_URL           origine du RELAIS (défaut http://localhost:3212) ; DOIT être NOMA_AUTH_ORIGIN du serveur
 *   NOMA_E2E_SERVER_LOG         fichier où la sortie du serveur est enregistrée (les lignes `[auth:dev]` y sont lues)
 *   NOMA_E2E_DATABASE_URL       base du serveur testé (pour la commande d'administration boost:grant) ; DOIT se terminer par /noma_e2e
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

/** Attend, après `offset` octets du journal du serveur, une ligne `[auth:dev]` et renvoie le code et les deux derniers chiffres affichés. */
export async function awaitOtpLine(offset: number): Promise<{ code: string; tail: string }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const text = readFileSync(E2E_SERVER_LOG).subarray(offset).toString("utf8");
    const match = OTP_LINE.exec(text);
    if (match) return { tail: match[1], code: match[2] };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("aucune ligne [auth:dev] dans la sortie du serveur (NODE_ENV=development et NOMA_DEV_OTP_CONSOLE=1 ?)");
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
    const { origin = this.base, noCookies = false, headers: given, ...rest } = init;
    const headers: Record<string, string> = { ...((given as Record<string, string> | undefined) ?? {}) };
    if (origin !== null) headers.origin = origin;
    const cookie = this.cookieHeader();
    if (cookie && !noCookies) headers.cookie = cookie;
    const response = await fetch(`${this.base}${path}`, {
      ...rest,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
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
  const offset = logSize();
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
