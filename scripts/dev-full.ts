import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import { isMatchingSchemaReady } from "../lib/server/matching/schema-ready";

/**
 * `npm run dev:full` : lance `next dev` ET le worker du matching (mode boucle) ensemble, pour le développement.
 * Ne remplace pas `npm run dev` (inchangé). N'applique AUCUNE migration. Aucun module serveur n'est chargé ici :
 * ce script n'a donc pas besoin de la condition `react-server` (qu'il retire d'ailleurs de l'environnement de Next).
 *
 * Variable d'environnement RÉSERVÉE AUX TESTS : NOMA_DEV_FULL_NEXT_SCRIPT=<chemin d'un script JS> remplace
 * `next dev` par `node <script>` (faux Next qui attend un signal).
 */
loadEnvConfig(process.cwd(), true, { info: () => {}, error: (...args: unknown[]) => console.error(...args) });

const KILL_GRACE_MS = 15_000;
const WORKER_ARGS = ["--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/matching-worker.ts"];

const log = (line: string) => console.log(`[dev:full] ${line}`);

/** Next ne doit pas hériter de la condition `react-server` (elle casserait son rendu). */
function nextEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.NODE_OPTIONS) {
    const cleaned = env.NODE_OPTIONS.split(/\s+/).filter((option) => option && option !== "--conditions=react-server").join(" ");
    if (cleaned) env.NODE_OPTIONS = cleaned;
    else delete env.NODE_OPTIONS;
  }
  return env;
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const options = [process.env.NODE_OPTIONS, "--conditions=react-server"].filter(Boolean).join(" ");
  return { ...process.env, NODE_OPTIONS: options };
}

/** Raison pour laquelle le worker ne doit pas être lancé, ou null s'il peut l'être. Jamais de message brut. */
async function workerSkipReason(): Promise<string | null> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return "DATABASE_URL n'est pas défini";
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
  pool.on("error", () => {});
  try {
    return (await isMatchingSchemaReady(pool))
      ? null
      : "le schéma n'est pas prêt (migration 0010_matching_job_leases absente ; appliquez-la avec npm run db:migrate)";
  } catch {
    return "la base est injoignable ou illisible";
  } finally {
    await pool.end().catch(() => {});
  }
}

function pipeWithPrefix(stream: Readable, sink: NodeJS.WriteStream): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      sink.write(`[matching] ${buffer.slice(0, index)}\n`);
      buffer = buffer.slice(index + 1);
    }
  });
  stream.on("end", () => { if (buffer) sink.write(`[matching] ${buffer}\n`); });
}

interface Managed {
  name: "next" | "worker";
  child: ChildProcess;
  exited: boolean;
}

async function main(): Promise<void> {
  const managed: Managed[] = [];
  let shuttingDown = false;
  let signalRequested = false;
  let failureCode: number | null = null;
  let killTimer: NodeJS.Timeout | undefined;

  const stopAll = (signal: NodeJS.Signals) => {
    for (const item of managed) if (!item.exited) item.child.kill(signal);
    killTimer ??= setTimeout(() => {
      for (const item of managed) if (!item.exited) item.child.kill("SIGKILL");
    }, KILL_GRACE_MS);
  };
  // SIGINT et SIGTERM sont relayés aux deux enfants sous la forme d'un SIGTERM : au Ctrl+C le terminal a DÉJÀ envoyé
  // SIGINT à tout le groupe, et un second SIGINT tuerait net le worker (il n'écoute SIGINT qu'une fois) en plein job.
  const onSignal = () => {
    signalRequested = true;
    shuttingDown = true;
    stopAll("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const track = (name: Managed["name"], child: ChildProcess) => {
    const item: Managed = { name, child, exited: false };
    managed.push(item);
    const finished = (description: string, code: number | null) => {
      if (item.exited) return;
      item.exited = true;
      if (!shuttingDown) {
        // Arrêt inattendu : l'autre enfant est arrêté et le code de sortie est non nul dès qu'il y avait deux enfants.
        log(`${name === "next" ? "next" : "worker matching"} s'est arrêté de façon inattendue (${description}).`);
        failureCode = managed.length > 1 ? (code && code !== 0 ? code : 1) : (code ?? 1);
        shuttingDown = true;
        stopAll("SIGTERM");
      }
      if (managed.every((entry) => entry.exited) && killTimer) clearTimeout(killTimer);
    };
    child.on("exit", (code, signal) => finished(signal ? `signal ${signal}` : `code ${code}`, code));
    child.on("error", () => finished("lancement impossible", 1));
    return item;
  };

  const nextOverride = process.env.NOMA_DEV_FULL_NEXT_SCRIPT?.trim();
  const reason = await workerSkipReason();
  if (signalRequested) return;

  const nextChild = nextOverride
    ? spawn(process.execPath, [nextOverride], { stdio: "inherit", env: nextEnvironment() })
    : spawn(join(process.cwd(), "node_modules", ".bin", "next"), ["dev"], { stdio: "inherit", env: nextEnvironment() });
  track("next", nextChild);
  log(`next démarré (pid ${nextChild.pid})`);

  if (reason) {
    log(`Worker matching NON lancé : ${reason}. Next démarre seul ; aucune migration n'est appliquée.`);
  } else {
    const workerChild = spawn(process.execPath, WORKER_ARGS, {
      cwd: process.cwd(), env: workerEnvironment(), stdio: ["ignore", "pipe", "pipe"],
    });
    pipeWithPrefix(workerChild.stdout!, process.stdout);
    pipeWithPrefix(workerChild.stderr!, process.stderr);
    track("worker", workerChild);
    log(`worker matching démarré (pid ${workerChild.pid})`);
  }

  await new Promise<void>((resolve) => {
    const check = () => { if (managed.every((entry) => entry.exited)) resolve(); };
    for (const item of managed) item.child.on("close", check);
    for (const item of managed) item.child.on("error", check);
  });
  if (killTimer) clearTimeout(killTimer);
  // Arrêt demandé : 0. Arrêt inattendu : le code de l'enfant (non nul dès qu'il y a deux enfants). Next seul : son code.
  process.exitCode = signalRequested ? 0 : (failureCode ?? 1);
}

main().catch(() => {
  console.error("[dev:full] erreur inattendue.");
  process.exitCode = 1;
});
