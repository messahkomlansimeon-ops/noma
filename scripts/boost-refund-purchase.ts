import { BOOST_ERROR_MESSAGES, BoostError } from "../lib/server/boost/boosts";
import { refundBoostPurchase } from "../lib/server/boost/purchase";
import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";

/**
 * COMMANDE D'ADMINISTRATION : rembourse INTÉGRALEMENT un achat de boost (lot P1b) : annule le boost s'il est encore actif, recrédite le
 * vendeur du montant payé, marque l'achat remboursé. Aucun prorata, aucune route HTTP. Usage :
 *   npm run boost:refund-purchase -- --purchase <uuid> --reason <code>
 * `<code>` : un motif en minuscules et tirets bas (1 à 40 caractères), conservé dans le grand livre. DATABASE_URL est obligatoire.
 * Code de sortie : 0 remboursé, 1 refus ou erreur. Aucun message brut : ni requête, ni identifiant inattendu, ni texte de la base (les
 * refus de domaine ont un code stable et un texte fixe : `purchase_not_found`, `already_refunded`).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASON = /^[a-z_]{1,40}$/;
const USAGE = "Usage : npm run boost:refund-purchase -- --purchase <uuid> --reason <code>";

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
  const result = await refundBoostPurchase({ pool: getPostgresPool(), purchaseId, reasonCode });
  console.log(
    `Boost (administration) remboursé : achat ${result.purchase.id}, ${result.refundedAmount.toString()} XOF recrédités ` +
    `(${result.boostCancelled ? "boost annulé" : "boost déjà terminé ou annulé"}).`,
  );
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof UsageError) console.error(`Boost (administration) : ${error.message}. ${USAGE}`);
    else if (error instanceof BoostError) console.error(`Boost (administration) : refus ${error.code} (${BOOST_ERROR_MESSAGES[error.code]})`);
    else if (error instanceof Error && error.name === "DatabaseConfigurationError") console.error(`Boost (administration) : ${error.message}`);
    else if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) console.error(`Boost (administration) : erreur ${code}.`);
    else console.error("Boost (administration) : erreur inattendue.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
