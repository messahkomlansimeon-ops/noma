import { spawn, type ChildProcess } from "node:child_process";

export interface ScriptResult {
  code: number | null;
  output: string;
}

function scriptEnvironment(schema: string, extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname)) {
    throw new Error("TEST_DATABASE_URL (base dédiée aux tests) est requis.");
  }
  return {
    ...process.env,
    NODE_ENV: "test",
    NODE_OPTIONS: "--conditions=react-server",
    DATABASE_URL: databaseUrl,
    PGOPTIONS: `-c search_path=${schema}`,
    ...extraEnv,
  };
}

const TSX_ARGS = ["--import", "./poc/node_modules/tsx/dist/loader.mjs"];

/**
 * Lance un vrai script tsx (même chargeur et même condition `react-server` que les scripts npm) sur la base de test,
 * dans le schéma temporaire donné via PGOPTIONS. DATABASE_URL pointe sur TEST_DATABASE_URL : jamais noma_dev.
 */
export function runScript(script: string, args: string[], schema: string, extraEnv: Record<string, string> = {}): Promise<ScriptResult> {
  let env: NodeJS.ProcessEnv;
  try {
    env = scriptEnvironment(schema, extraEnv);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...TSX_ARGS, script, ...args], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("script trop long")); }, 60_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

export interface RunningScript {
  child: ChildProcess;
  /** Sortie (stdout + stderr) accumulée. */
  output(): string;
  /** Attend un motif dans la sortie ; rejette (avec la sortie) après `timeoutMs`. */
  waitForOutput(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Variante de runScript pour un script de longue durée : expose le processus, sa sortie et sa fin. */
export function spawnScript(script: string, args: string[], schema: string, extraEnv: Record<string, string> = {}): RunningScript {
  const child = spawn(process.execPath, [...TSX_ARGS, script, ...args], {
    cwd: process.cwd(), env: scriptEnvironment(schema, extraEnv), stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    output: () => output,
    exited,
    waitForOutput: (pattern, timeoutMs = 30_000) => new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const match = pattern.exec(output);
        if (match) { clearInterval(poll); resolve(match); }
        else if (Date.now() - started > timeoutMs) { clearInterval(poll); reject(new Error(`motif ${pattern} absent après ${timeoutMs} ms. Sortie :\n${output}`)); }
      }, 50);
    }),
  };
}
