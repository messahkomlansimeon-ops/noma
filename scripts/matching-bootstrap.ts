import { getPostgresPool, closePostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";
import { MatchingBootstrapError, runCatalogBootstrap } from "../lib/server/matching/bootstrap";

/**
 * Bootstrap du catalogue existant pour le matching asynchrone. Simulation par défaut ; `--apply` écrit.
 * N'applique AUCUNE migration (elles doivent avoir été appliquées par l'opérateur) et n'est jamais lancé par Next.js.
 */
async function main(): Promise<void> {
  requireDatabaseUrl();
  const apply = process.argv.slice(2).includes("--apply");
  const result = await runCatalogBootstrap({ pool: getPostgresPool(), dryRun: !apply });
  console.log(
    `Bootstrap ${apply ? "appliqué" : "(simulation, rien n'est écrit)"} : ${result.offersScanned} offre(s) et ` +
    `${result.demandsScanned} demande(s) éligibles parcourues, ${result.jobsInserted} job(s) ` +
    `${apply ? "créé(s)" : "à créer"}, ${result.alreadyCovered} déjà couverte(s).`,
  );
  if (!apply) console.log("Relancez avec --apply pour créer les jobs.");
}

main()
  .catch((error: unknown) => {
    // Jamais de message brut inattendu : il peut contenir hôte, identifiants ou requête.
    const code = (error as { code?: unknown } | null)?.code;
    console.error(
      error instanceof MatchingBootstrapError || (error instanceof Error && error.name === "DatabaseConfigurationError")
        ? `Matching bootstrap : ${error.message}`
        : typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)
          ? `Matching bootstrap : erreur ${code}.`
          : "Matching bootstrap : erreur inattendue.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
