import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";
import { SUBSCRIPTION_ERROR_MESSAGES, SubscriptionError } from "../lib/server/subscriptions/errors";
import { refundSubscriptionPeriod } from "../lib/server/subscriptions/lifecycle";

/**
 * COMMANDE D'ADMINISTRATION : rembourse INTÉGRALEMENT une période d'abonnement (lot PRO1), même mécanisme que `boost:refund-purchase` : le prix payé est recrédité en crédits payés ;
 * le reste promotionnel INUTILISÉ de la période est annulé (écrit au grand livre) ; si c'est la période courante d'un abonnement en vigueur, l'abonnement prend fin (annonces au-delà de
 * la limite du plan Gratuit en pause, vendeur averti). Les crédits promotionnels déjà dépensés ne sont pas repris. Aucun prorata, aucune route HTTP. Usage :
 *   npm run subscription:refund-period -- --period <uuid> --reason <code>
 * `<code>` : un motif en minuscules et tirets bas (1 à 40 caractères), conservé dans le grand livre. DATABASE_URL est obligatoire.
 * Code de sortie : 0 remboursé, 1 refus ou erreur. Aucun message brut (refus de domaine : `period_not_found`, `already_refunded`).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASON = /^[a-z_]{1,40}$/;
const USAGE = "Usage : npm run subscription:refund-period -- --period <uuid> --reason <code>";

class UsageError extends Error {}

function parseArgs(args: string[]): { periodId: string; reasonCode: string } {
  let periodId: string | undefined;
  let reason: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError("valeur manquante");
    if (flag === "--period" && periodId === undefined) periodId = value;
    else if (flag === "--reason" && reason === undefined) reason = value;
    else throw new UsageError("argument inconnu ou répété");
  }
  if (periodId === undefined || !UUID.test(periodId)) throw new UsageError("--period doit être un UUID");
  if (reason === undefined || !REASON.test(reason)) throw new UsageError("--reason doit être un code en minuscules et tirets bas (1 à 40 caractères)");
  return { periodId: periodId.toLowerCase(), reasonCode: reason };
}

async function main(): Promise<number> {
  const { periodId, reasonCode } = parseArgs(process.argv.slice(2));
  requireDatabaseUrl();
  const result = await refundSubscriptionPeriod({ pool: getPostgresPool(), periodId, reasonCode });
  console.log(
    `Abonnement (administration) remboursé : période ${result.periodId}, ${result.refundedAmount.toString()} XOF recrédités, ` +
    `${result.promoCancelled.toString()} XOF de crédits promotionnels inutilisés annulés, ` +
    `${result.subscriptionEnded ? `abonnement terminé (${result.pausedOffers} annonce(s) mise(s) en pause)` : "abonnement inchangé"}.`,
  );
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof UsageError) console.error(`Abonnement (administration) : ${error.message}. ${USAGE}`);
    else if (error instanceof SubscriptionError) console.error(`Abonnement (administration) : refus ${error.code} (${SUBSCRIPTION_ERROR_MESSAGES[error.code]})`);
    else if (error instanceof Error && error.name === "DatabaseConfigurationError") console.error(`Abonnement (administration) : ${error.message}`);
    else if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) console.error(`Abonnement (administration) : erreur ${code}.`);
    else console.error("Abonnement (administration) : erreur inattendue.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
