import { closePostgresPool } from "../lib/server/postgres/client";
import { runMigrations } from "../lib/server/postgres/migrations";

async function main(): Promise<void> {
  const result = await runMigrations();
  console.log(
    `Migrations PostgreSQL : ${result.applied.length} appliquée(s), ${result.skipped.length} déjà présente(s).`,
  );
  for (const version of result.applied) console.log(`  + ${version}`);
  for (const version of result.skipped) console.log(`  = ${version}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
