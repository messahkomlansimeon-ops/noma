import { Pool } from "pg";
import { openVerifiedTestDatabase, quoteTemporarySchema } from "../tests/postgres/test-database";

/**
 * Supprime les schémas `noma_test_<pid>_<32 hex>` laissés par des processus de test interrompus.
 * Simulation par défaut (liste seulement) ; `--apply` supprime. Ne vise que la base dédiée aux tests
 * (mêmes protections que les suites : TEST_DATABASE_URL, nom de base contenant « test »).
 */
const ORPHAN_SCHEMA = /^noma_test_(\d+)_[0-9a-f]{32}$/;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH : aucun processus. EPERM : le processus existe mais appartient à un autre utilisateur.
    return (error as { code?: string }).code !== "ESRCH";
  }
}

async function listSchemas(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'noma\\_test\\_%' ORDER BY nspname");
  return result.rows.map((row) => row.nspname);
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  const { target, pool } = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  try {
    const all = await listSchemas(pool);
    const orphans: string[] = [];
    for (const name of all) {
      const match = ORPHAN_SCHEMA.exec(name);
      if (!match) {
        console.log(`ignoré (nom non conforme) : ${name}`);
      } else if (isProcessAlive(Number(match[1]))) {
        console.log(`conservé (processus ${match[1]} vivant) : ${name}`);
      } else {
        orphans.push(name);
      }
    }
    console.log(`Base ${target.databaseName} : ${all.length} schéma(s) noma_test_*, ${orphans.length} orphelin(s).`);
    for (const name of orphans) console.log(`  orphelin : ${name}`);
    if (orphans.length === 0) return;

    const others = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`);
    if (Number(others.rows[0].n) > 0) {
      throw new Error(`Refus : ${others.rows[0].n} autre(s) session(s) sur la base de test. Arrêtez les tests en cours puis relancez.`);
    }
    if (!apply) {
      console.log("Simulation : aucun schéma supprimé. Relancez avec --apply pour supprimer les orphelins ci-dessus.");
      return;
    }
    for (const name of orphans) {
      await pool.query(`DROP SCHEMA ${quoteTemporarySchema(name)} CASCADE`);
      console.log(`supprimé : ${name}`);
    }
    console.log(`${orphans.length} schéma(s) supprimé(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
