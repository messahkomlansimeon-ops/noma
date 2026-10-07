import {
  DELIVERIES_RETENTION_DAYS,
  NOTIFICATIONS_PURGE_PRODUCTION_VARIABLE,
  NOTIFICATIONS_READ_RETENTION_DAYS,
  NOTIFICATIONS_RETENTION_DAYS,
} from "../lib/server/notifications/config";
import { purgeNotifications } from "../lib/server/notifications/purge";
import { purgeEnvironmentRefusal } from "../lib/server/metrics/purge";
import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";

/**
 * COMMANDE D'ADMINISTRATION (lot N1) : rétention des notifications. Usage :
 *   npm run notifications:purge              simulation : compte, ne supprime rien
 *   npm run notifications:purge -- --apply   supprime
 * Supprime les `notifications` LUES depuis plus de 90 jours ou CRÉÉES depuis plus de 180 jours, et les `notification_deliveries` de plus de 180 jours.
 * DATABASE_URL est obligatoire. Même garde d'environnement que `metrics:purge` : elle ne s'exécute que si NODE_ENV est absent, « development » ou « test »
 * (casse exacte) ; toute autre valeur est refusée, simulation comprise ; en production (`NODE_ENV=production`) il faut en plus
 * `NOMA_NOTIFICATIONS_PURGE_PRODUCTION=1`. Code de sortie : 0 réussi, 1 refus ou erreur. Aucun message brut.
 */
const USAGE = "Usage : npm run notifications:purge [-- --apply]";

class UsageError extends Error {}
class RefusalError extends Error {}

function parseArgs(args: string[]): { apply: boolean } {
  if (args.length === 0) return { apply: false };
  if (args.length === 1 && args[0] === "--apply") return { apply: true };
  throw new UsageError("argument inconnu ou répété");
}

async function main(): Promise<number> {
  const { apply } = parseArgs(process.argv.slice(2));
  const refusal = purgeEnvironmentRefusal(process.env, NOTIFICATIONS_PURGE_PRODUCTION_VARIABLE);
  if (refusal !== null) throw new RefusalError(refusal);
  requireDatabaseUrl();
  const result = await purgeNotifications({ pool: getPostgresPool(), apply });
  const { notifications, notification_deliveries: deliveries } = result.counts;
  const detail =
    `${notifications} notification(s) (lues depuis plus de ${NOTIFICATIONS_READ_RETENTION_DAYS} jours ou créées depuis plus de ${NOTIFICATIONS_RETENTION_DAYS} jours) ` +
    `et ${deliveries} envoi(s) externe(s) de plus de ${DELIVERIES_RETENTION_DAYS} jours`;
  if (apply) console.log(`Notifications : ${detail} supprimé(s).`);
  else console.log(`Notifications : simulation, ${detail} seraient supprimé(s). Rien n'a été supprimé : relancez avec --apply pour supprimer.`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof UsageError) console.error(`Notifications : ${error.message}. ${USAGE}`);
    else if (error instanceof RefusalError) console.error(`Notifications : ${error.message}`);
    else if (error instanceof Error && error.name === "DatabaseConfigurationError") console.error(`Notifications : ${error.message}`);
    else if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) console.error(`Notifications : erreur ${code}.`);
    else console.error("Notifications : erreur inattendue.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
