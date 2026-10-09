import { ACTIVE_SEARCH_ERROR_MESSAGES, ActiveSearchError } from "../lib/server/active-search/errors";
import { refundActiveSearchPurchase } from "../lib/server/active-search/refund";
import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";

/**
 * COMMANDE D'ADMINISTRATION : rembourse INTÉGRALEMENT un achat de recherche active (lot RA1), même mécanisme que `boost:refund-purchase` et `subscription:refund-period` : le prix payé est
 * recrédité en crédits payés ; si la période est encore en vigueur, elle s'arrête. Aucun prorata, aucune route HTTP. Le plus récent achat d'un besoin se rembourse d'abord. Usage :
 *   npm run active-search:refund -- --purchase <uuid> --reason <code>
 * `<code>` : un motif en minuscules et tirets bas (1 à 40 caractères), conservé dans le grand livre. DATABASE_URL est obligatoire.
 * Code de sortie : 0 remboursé, 1 refus ou erreur. Aucun message brut (refus de domaine : `purchase_not_found`, `already_refunded`, `later_period_exists`).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASON = /^[a-z_]{1,40}$/;
const USAGE = "Usage : npm run active-search:refund -- --purchase <uuid> --reason <code>";

class UsageError extends Error {}

function parseArgs(args: string[]): { purchaseId: string; reasonCode: string } {
  let purchaseId: string | undefined;
  let reason: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError("valeur manquante");
    if (flag === "--purchase" && purchaseId === undefined) purchaseId = value;
    else if (flag === "--reason" && reason === undefined) reason = value;
    else throw new UsageError("argument inconnu ou répété");
  }
  if (purchaseId === undefined || !UUID.test(purchaseId)) throw new UsageError("--purchase doit être un UUID");
  if (reason === undefined || !REASON.test(reason)) throw new UsageError("--reason doit être un code en minuscules et tirets bas (1 à 40 caractères)");
  return { purchaseId: purchaseId.toLowerCase(), reasonCode: reason };
}

async function main(): Promise<number> {
  const { purchaseId, reasonCode } = parseArgs(process.argv.slice(2));
  requireDatabaseUrl();
  const result = await refundActiveSearchPurchase({ pool: getPostgresPool(), purchaseId, reasonCode });
  console.log(
    `Recherche active (administration) remboursée : achat ${result.purchaseId}, ${result.refundedAmount.toString()} XOF recrédités, ` +
    `${result.stopped ? "période arrêtée" : "période déjà terminée ou arrêtée"}.`,
  );
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof UsageError) console.error(`Recherche active (administration) : ${error.message}. ${USAGE}`);
    else if (error instanceof ActiveSearchError) console.error(`Recherche active (administration) : refus ${error.code} (${ACTIVE_SEARCH_ERROR_MESSAGES[error.code]})`);
    else if (error instanceof Error && error.name === "DatabaseConfigurationError") console.error(`Recherche active (administration) : ${error.message}`);
    else if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) console.error(`Recherche active (administration) : erreur ${code}.`);
    else console.error("Recherche active (administration) : erreur inattendue.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
