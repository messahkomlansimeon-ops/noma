import { spawn } from "node:child_process";

export interface ScriptResult {
  code: number | null;
  output: string;
}

/**
 * Lance un vrai script tsx (même chargeur et même condition `react-server` que les scripts npm) sur la base de test,
 * dans le schéma temporaire donné via PGOPTIONS. DATABASE_URL pointe sur TEST_DATABASE_URL : jamais noma_dev.
 */
export function runScript(script: string, args: string[], schema: string, extraEnv: Record<string, string> = {}): Promise<ScriptResult> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname)) {
    return Promise.reject(new Error("TEST_DATABASE_URL (base dédiée aux tests) est requis."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "./poc/node_modules/tsx/dist/loader.mjs", script, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        NODE_OPTIONS: "--conditions=react-server",
        DATABASE_URL: databaseUrl,
        PGOPTIONS: `-c search_path=${schema}`,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("script trop long")); }, 60_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
