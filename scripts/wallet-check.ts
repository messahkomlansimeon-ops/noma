import { checkWalletIntegrity, WALLET_CHECK_EXAMPLE_LIMIT, type WalletCheckReport } from "../lib/server/wallet/check";
import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";

/**
 * COMMANDE D'ADMINISTRATION (lecture seule) : contrôle de réconciliation du portefeuille. Usage :
 *   npm run wallet:check [-- --strict]
 * DATABASE_URL est obligatoire. Code de sortie : 0 aucun écart, 1 au moins un écart (rapport sur la sortie standard) ou, avec
 * --strict, au moins un avertissement, 2 erreur d'usage ou technique. Les AVERTISSEMENTS (payment.succeeded refusés : argent
 * peut-être encaissé sans crédit, à traiter à la main) sont listés à part et ne changent pas le code de sortie sans --strict.
 * Le rapport ne contient aucune donnée personnelle : comptages, identifiants techniques et montants.
 */
const USAGE = "Usage : npm run wallet:check [-- --strict]";

class UsageError extends Error {}

function printWarnings(report: WalletCheckReport): void {
  if (report.warnings.length === 0) return;
  console.log(
    "AVERTISSEMENTS (payment.succeeded refusés : de l'argent a peut-être été encaissé chez le prestataire sans crédit, " +
    "à traiter à la main ; sans effet sur le code de sortie hors --strict) :",
  );
  for (const warning of report.warnings) {
    console.log(`AVERTISSEMENT ${warning.code} : ${warning.count} événement(s) (${warning.examples.length} exemple(s) affiché(s), ${WALLET_CHECK_EXAMPLE_LIMIT} au plus).`);
    for (const example of warning.examples) {
      console.log(`  ${Object.entries(example).map(([key, value]) => `${key}=${value}`).join(" ")}`);
    }
  }
}

function printReport(report: WalletCheckReport): void {
  const { totals } = report;
  console.log(
    `Portefeuille : ${totals.accounts} compte(s), ${totals.transactions} transaction(s), ${totals.entries} écriture(s), ` +
    `${totals.paymentIntents} intention(s) de paiement, ${totals.paymentEvents} événement(s) du prestataire.`,
  );
  if (report.ok) {
    console.log("Portefeuille : aucun écart.");
    printWarnings(report);
    return;
  }
  console.log(`Portefeuille : ${report.violations.length} type(s) d'écart.`);
  for (const violation of report.violations) {
    console.log(`ÉCART ${violation.code} : ${violation.count} cas (${violation.examples.length} exemple(s) affiché(s), ${WALLET_CHECK_EXAMPLE_LIMIT} au plus).`);
    for (const example of violation.examples) {
      console.log(`  ${Object.entries(example).map(([key, value]) => `${key}=${value}`).join(" ")}`);
    }
  }
  printWarnings(report);
}

function parseArgs(args: string[]): { strict: boolean } {
  if (args.length === 0) return { strict: false };
  if (args.length === 1 && args[0] === "--strict") return { strict: true };
  throw new UsageError("argument inconnu ou répété");
}

async function main(): Promise<number> {
  const { strict } = parseArgs(process.argv.slice(2));
  requireDatabaseUrl();
  const report = await checkWalletIntegrity(getPostgresPool());
  printReport(report);
  if (!report.ok) return 1;
  if (strict && report.warnings.length > 0) {
    console.log(`Portefeuille : mode strict, ${report.warnings.length} type(s) d'avertissement : code de sortie 1.`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof UsageError) console.error(`Portefeuille : ${error.message}. ${USAGE}`);
    else if (error instanceof Error && error.name === "DatabaseConfigurationError") console.error(`Portefeuille : ${error.message}`);
    else if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) console.error(`Portefeuille : erreur ${code}.`);
    else console.error("Portefeuille : erreur inattendue.");
    process.exitCode = 2;
  })
  .finally(async () => {
    await closePostgresPool();
  });
