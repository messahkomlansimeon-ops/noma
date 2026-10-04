/**
 * Runtime des protections (Lot 5) — singleton config + SQLite par processus.
 * SERVEUR UNIQUEMENT.
 */
import "server-only";
import { loadConfig, assertProductionConfig, type GuardConfig } from "./config";
import { openGuardDb, type GuardDatabase } from "./db";

let runtime: { cfg: GuardConfig; db: GuardDatabase } | null = null;

export function guard(): { cfg: GuardConfig; db: GuardDatabase } {
  if (!runtime) {
    const cfg = loadConfig();
    assertProductionConfig(cfg); // production : fail closed sans config anti-bot
    runtime = { cfg, db: openGuardDb(cfg.dbPath).db };
  }
  return runtime;
}