import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, test } from "node:test";

/**
 * Outil de démonstration `active-search:simulate` (lot RA1) : arguments stricts, refus AVANT toute connexion (production, bases `noma_dev` et `noma_test`, base distante), aucune trace d'adresse
 * ni de secret. Son effet sur une base d'essai est vérifié par tests/postgres/active-search-external.integration.test.ts (service) et par `e2e:demo` (commande).
 */

const LOADER = "./poc/node_modules/tsx/dist/loader.mjs";
const SCRIPT = "scripts/active-search-simulate.ts";
const DEMAND = "22222222-2222-4222-8222-222222222222";
const DEAD = "postgresql://noma_local:secret@127.0.0.1:1/noma_essai";

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", LOADER, SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: "--conditions=react-server", ...env } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe("active-search:simulate refuse avant toute connexion", () => {
  test("arguments : aucun, identifiant invalide, option inconnue, argument en trop → code 1 et l'usage", async () => {
    for (const args of [[], ["--demand"], ["--demand", "pas-un-uuid"], ["--demand", DEMAND, "--force"], ["--other", DEMAND], [DEMAND]]) {
      const result = await run(args, { NODE_ENV: "development", DATABASE_URL: DEAD });
      assert.equal(result.code, 1, JSON.stringify(args));
      assert.match(result.output, /active-search:simulate : arguments invalides\. Usage : npm run active-search:simulate -- --demand <uuid>/);
      assert.equal(/ECONNREFUSED|erreur inattendue|secret/.test(result.output), false, `aucune connexion tentée : ${result.output}`);
    }
  });

  test("production, noma_dev, noma_test, une autre base et une base distante : code 1, motif lisible qui nomme l'outil, jamais l'adresse ni le mot de passe", async () => {
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ["production", { NODE_ENV: "production", DATABASE_URL: DEAD }, /refus — NODE_ENV vaut « production »/],
      ["noma_dev", { NODE_ENV: "development", DATABASE_URL: DEAD.replace("noma_essai", "noma_dev") }, /refus — active-search:simulate ne peuple que les bases d'essai noma_essai, noma_e2e et noma_essai_\*/],
      ["noma_test", { NODE_ENV: "development", DATABASE_URL: DEAD.replace("noma_essai", "noma_test") }, /refus — active-search:simulate ne peuple que les bases d'essai/],
      ["noma_prod", { NODE_ENV: "development", DATABASE_URL: DEAD.replace("noma_essai", "noma_prod") }, /refus/],
      ["distante", { NODE_ENV: "development", DATABASE_URL: "postgresql://u:secret@db.example.com:5432/noma_essai" }, /refus/],
      ["sans DATABASE_URL", { NODE_ENV: "development" }, /refus/],
    ];
    for (const [label, env, pattern] of cases) {
      const result = await run(["--demand", DEMAND], env);
      assert.equal(result.code, 1, label);
      assert.match(result.output, pattern, label);
      assert.equal(/ECONNREFUSED|erreur inattendue|db\.example\.com|secret/.test(result.output), false, `${label} : ${result.output}`);
    }
  });
});
