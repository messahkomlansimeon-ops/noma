import { BOOST_ERROR_MESSAGES, BoostError } from "../lib/server/boost/boosts";
import { readOfferBoostExposureStats, type BoostExposureStatus } from "../lib/server/boost/exposures";
import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";

/**
 * COMMANDE D'ADMINISTRATION (lecture seule) : statistiques d'exposition des boosts d'une offre. Usage :
 *   npm run boost:stats -- --offer <uuid>
 * DATABASE_URL est obligatoire. Code de sortie : 0 statistiques affichées, 1 refus ou erreur. Aucun message brut : ni requête, ni
 * identifiant inattendu, ni texte de la base. Les statistiques sont des comptages : jamais d'identité d'acheteur.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USAGE = "Usage : npm run boost:stats -- --offer <uuid>";
const STATUS_LABELS: Record<BoostExposureStatus, string> = { effective: "effectif", expired: "expiré", cancelled: "annulé", scheduled: "programmé" };

class UsageError extends Error {}

function parseArgs(args: string[]): { offerId: string } {
  if (args.length !== 2 || args[0] !== "--offer" || args[1].startsWith("--")) throw new UsageError("argument manquant, inconnu ou répété");
  if (!UUID.test(args[1])) throw new UsageError("--offer doit être un UUID");
  return { offerId: args[1].toLowerCase() };
}

async function main(): Promise<number> {
  const { offerId } = parseArgs(process.argv.slice(2));
  requireDatabaseUrl();
  const pool = getPostgresPool();
  // Le propriétaire est celui de l'offre (l'administration lit « au nom » du vendeur, comme pour l'attribution).
  const owner = await pool.query<{ owner_id: string }>("SELECT owner_id FROM offers WHERE id = $1::uuid", [offerId]);
  if (!owner.rows[0]) throw new BoostError("offer_not_found");
  const stats = await readOfferBoostExposureStats({ pool, ownerId: owner.rows[0].owner_id, offerId });
  console.log(`Boost (administration) : exposition de l'offre ${offerId}, ${stats.length} boost(s).`);
  for (const boost of stats) {
    console.log(
      `${boost.boostId} | ${boost.durationCode} | ${STATUS_LABELS[boost.status]} | du ${boost.startsAt.toISOString()} au ${boost.endsAt.toISOString()} | ` +
      `apparitions servies : ${boost.servings} (dont ${boost.sponsoredServings} sponsorisée(s)) | ` +
      `acheteurs uniques : ${boost.uniqueBuyersExposed} exposé(s), ${boost.uniqueBuyersSponsored} sponsorisé(s) | ` +
      `meilleure position : ${boost.bestPosition ?? "aucune"} | gain maximal : ${boost.bestGain ?? "aucun"} | jours actifs : ${boost.activeDays}`,
    );
  }
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
