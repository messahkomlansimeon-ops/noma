import { MARKET_RETENTION_DAYS } from "../lib/server/market/config";
import { METRICS_RETENTION_DAYS } from "../lib/server/metrics/config";
import { purgeEnvironmentRefusal, purgeMetrics } from "../lib/server/metrics/purge";
import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";

/**
 * COMMANDE D'ADMINISTRATION (lot M1) : rétention des mesures. Usage :
 *   npm run metrics:purge              simulation : compte, ne supprime rien
 *   npm run metrics:purge -- --apply   supprime
 * Supprime les lignes de `boost_exposures`, `offer_views` et `offer_contacts` de PLUS de 400 jours (jour UTC servi, d'ouverture ou du dernier contact), et (lot H1) les
 * relevés de prix `price_observations` de PLUS de 3 ans (1 095 jours, jour UTC du relevé ; sans la migration 0023, rien à supprimer).
 * Les statistiques agrégées ne sont pas conservées au-delà. DATABASE_URL est obligatoire. Elle ne s'exécute que si NODE_ENV est absent, « development » ou « test » (casse exacte) :
 * toute autre valeur est refusée, simulation comprise ; en production (`NODE_ENV=production`) il faut en plus `NOMA_METRICS_PURGE_PRODUCTION=1`. Code de sortie : 0 réussi, 1 refus ou erreur. Aucun message brut.
 */
const USAGE = "Usage : npm run metrics:purge [-- --apply]";

class UsageError extends Error {}
class RefusalError extends Error {}

function parseArgs(args: string[]): { apply: boolean } {
  if (args.length === 0) return { apply: false };
  if (args.length === 1 && args[0] === "--apply") return { apply: true };
  throw new UsageError("argument inconnu ou répété");
}

async function main(): Promise<number> {
  const { apply } = parseArgs(process.argv.slice(2));
  const refusal = purgeEnvironmentRefusal(process.env);
  if (refusal !== null) throw new RefusalError(refusal);
  requireDatabaseUrl();
  const result = await purgeMetrics({ pool: getPostgresPool(), apply });
  const { boost_exposures: exposures, offer_views: views, offer_contacts: contacts, price_observations: prices } = result.counts;
  const detail = `${exposures} ligne(s) de boost_exposures, ${views} d'offer_views, ${contacts} d'offer_contacts de plus de ${METRICS_RETENTION_DAYS} jours (avant le ${result.cutoffDay} UTC)`;
  const marketDetail = `${prices} relevé(s) de prix de plus de ${MARKET_RETENTION_DAYS} jours (avant le ${result.marketCutoffDay} UTC)`;
  if (apply) {
    console.log(`Mesures : ${detail} supprimée(s).`);
    console.log(`Historique des prix : ${marketDetail} supprimé(s).`);
  } else {
    console.log(`Mesures : simulation, ${detail} seraient supprimée(s). Rien n'a été supprimé : relancez avec --apply pour supprimer.`);
    console.log(`Historique des prix : simulation, ${marketDetail} seraient supprimé(s). Rien n'a été supprimé : relancez avec --apply pour supprimer.`);
  }
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof UsageError) console.error(`Mesures : ${error.message}. ${USAGE}`);
    else if (error instanceof RefusalError) console.error(`Mesures : ${error.message}`);
    else if (error instanceof Error && error.name === "DatabaseConfigurationError") console.error(`Mesures : ${error.message}`);
    else if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) console.error(`Mesures : erreur ${code}.`);
    else console.error("Mesures : erreur inattendue.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
