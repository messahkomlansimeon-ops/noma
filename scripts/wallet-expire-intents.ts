import { TOPUP_EXPIRY_DEFAULT_LIMIT, TOPUP_EXPIRY_MAX_LIMIT } from "../lib/server/wallet/config";
import { expirePaymentIntents } from "../lib/server/wallet/topups";
import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";

/**
 * COMMANDE D'ADMINISTRATION : marque `expired` les intentions de recharge `pending` dont l'échéance est passée. Usage :
 *   npm run wallet:expire-intents [-- --limit <1 à 1000>]
 * DATABASE_URL est obligatoire. Plusieurs exécutions simultanées sont sûres (lignes verrouillées ignorées). Code de sortie : 0
 * réussi, 1 refus ou erreur. Aucun message brut : ni requête, ni identifiant, ni texte de la base.
 */
const USAGE = `Usage : npm run wallet:expire-intents [-- --limit <1 à ${TOPUP_EXPIRY_MAX_LIMIT}>]`;

class UsageError extends Error {}

function parseArgs(args: string[]): { limit: number } {
  if (args.length === 0) return { limit: TOPUP_EXPIRY_DEFAULT_LIMIT };
  if (args.length !== 2 || args[0] !== "--limit" || !/^[0-9]{1,4}$/.test(args[1])) throw new UsageError("argument manquant, inconnu ou répété");
  const limit = Number(args[1]);
  if (limit < 1 || limit > TOPUP_EXPIRY_MAX_LIMIT) throw new UsageError(`--limit doit être compris entre 1 et ${TOPUP_EXPIRY_MAX_LIMIT}`);
  return { limit };
}

async function main(): Promise<number> {
  const { limit } = parseArgs(process.argv.slice(2));
  requireDatabaseUrl();
  const result = await expirePaymentIntents({ pool: getPostgresPool(), limit });
  console.log(`Portefeuille : ${result.expired} intention(s) de recharge marquée(s) expirée(s) (limite ${limit}).`);
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
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
