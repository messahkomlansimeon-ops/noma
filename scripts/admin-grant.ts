import { ADMIN_ERROR_MESSAGES, AdminError } from "../lib/server/admin/errors";
import { adminGrantEnvironmentRefusal, grantAdmin } from "../lib/server/admin/grant";
import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";

/**
 * COMMANDE D'ADMINISTRATION (lot D2) : attribue le rôle d'administration au compte dont le numéro vérifié est donné. Usage :
 *   npm run admin:grant -- "07 00 00 03 03"      (ou +2250700000303)
 * C'est LE SEUL moyen d'attribuer le rôle (un déclencheur de la base refuse tout autre UPDATE ou INSERT de `users.is_admin` à TRUE). Elle ne s'exécute que si NODE_ENV est
 * absent, « development » ou « test » (casse exacte) ; en production (`NODE_ENV=production`) il faut en plus `NOMA_ADMIN_GRANT_PRODUCTION=1`, sinon refus sans rien écrire.
 * DATABASE_URL est obligatoire. Code de sortie : 0 réussi (ou déjà administrateur), 1 refus ou erreur. Aucun message brut.
 */
const USAGE = "Usage : npm run admin:grant -- <numéro de téléphone>";

class UsageError extends Error {}
class RefusalError extends Error {}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("--")) throw new UsageError("un seul argument est attendu : le numéro de téléphone");
  const refusal = adminGrantEnvironmentRefusal(process.env);
  if (refusal !== null) throw new RefusalError(refusal);
  requireDatabaseUrl();
  const result = await grantAdmin({ pool: getPostgresPool(), phone: args[0] });
  console.log(result.granted ? "Administration : rôle admin attribué à ce compte." : "Administration : ce compte était déjà administrateur (rien n'a changé).");
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof UsageError) console.error(`Administration : ${error.message}. ${USAGE}`);
    else if (error instanceof RefusalError) console.error(`Administration : ${error.message}`);
    else if (error instanceof AdminError) console.error(`Administration : ${ADMIN_ERROR_MESSAGES[error.code]}`);
    else if (error instanceof Error && error.name === "DatabaseConfigurationError") console.error(`Administration : ${error.message}`);
    else if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) console.error(`Administration : erreur ${code}.`);
    else console.error("Administration : erreur inattendue.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
