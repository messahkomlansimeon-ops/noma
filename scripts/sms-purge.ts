import { SMS_PURGE_PRODUCTION_VARIABLE, SMS_SENDS_RETENTION_DAYS } from "../lib/server/sms/config";
import { purgeSmsSends } from "../lib/server/sms/purge";
import { purgeEnvironmentRefusal } from "../lib/server/metrics/purge";
import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";

/**
 * COMMANDE D'ADMINISTRATION (lot MEN1) : rétention du journal des SMS. Usage :
 *   npm run sms:purge              simulation : compte, ne supprime rien
 *   npm run sms:purge -- --apply   supprime
 * Supprime les lignes de `sms_sends` créées depuis plus de 62 jours, SAUF celles encore `uncertain` ou `pending` (rapprochement de l'administration).
 * DATABASE_URL est obligatoire. Même garde d'environnement que `notifications:purge` : elle ne s'exécute que si NODE_ENV est absent, « development » ou « test »
 * (casse exacte) ; toute autre valeur est refusée, simulation comprise ; en production (`NODE_ENV=production`) il faut en plus `NOMA_SMS_PURGE_PRODUCTION=1`.
 * Code de sortie : 0 réussi, 1 refus ou erreur. Aucun message brut.
 */
const USAGE = "Usage : npm run sms:purge [-- --apply]";

class UsageError extends Error {}
class RefusalError extends Error {}

function parseArgs(args: string[]): { apply: boolean } {
  if (args.length === 0) return { apply: false };
  if (args.length === 1 && args[0] === "--apply") return { apply: true };
  throw new UsageError("argument inconnu ou répété");
}

async function main(): Promise<number> {
  const { apply } = parseArgs(process.argv.slice(2));
  const refusal = purgeEnvironmentRefusal(process.env, SMS_PURGE_PRODUCTION_VARIABLE);
  if (refusal !== null) throw new RefusalError(refusal);
  requireDatabaseUrl();
  const result = await purgeSmsSends({ pool: getPostgresPool(), apply });
  const detail = `${result.sms_sends} envoi(s) de SMS créés depuis plus de ${SMS_SENDS_RETENTION_DAYS} jours (hors incertains et en cours)`;
  if (apply) console.log(`SMS : ${detail} supprimé(s).`);
  else console.log(`SMS : simulation, ${detail} seraient supprimé(s). Rien n'a été supprimé : relancez avec --apply pour supprimer.`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof UsageError) console.error(`SMS : ${error.message}. ${USAGE}`);
    else if (error instanceof RefusalError) console.error(`SMS : ${error.message}`);
    else if (error instanceof Error && error.name === "DatabaseConfigurationError") console.error(`SMS : ${error.message}`);
    else if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) console.error(`SMS : erreur ${code}.`);
    else console.error("SMS : erreur inattendue.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
