import { BOOST_DURATION_CODES, type BoostDurationCode } from "../lib/server/boost/boost-config";
import { BOOST_ERROR_MESSAGES, BoostError, grantOfferBoost } from "../lib/server/boost/boosts";
import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";

/**
 * COMMANDE D'ADMINISTRATION : attribue un boost à une offre (aucun paiement, aucun crédit). Usage :
 *   npm run boost:grant -- --offer <uuid> --duration 24h|3d|7d
 * DATABASE_URL est obligatoire. Code de sortie : 0 attribué, 1 refus ou erreur. Aucun message brut : ni requête,
 * ni identifiant inattendu, ni texte de la base (les refus de domaine ont un code stable et un texte fixe).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USAGE = "Usage : npm run boost:grant -- --offer <uuid> --duration 24h|3d|7d";

class UsageError extends Error {}

function parseArgs(args: string[]): { offerId: string; durationCode: BoostDurationCode } {
  let offerId: string | undefined;
  let duration: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError("valeur manquante");
    if (flag === "--offer" && offerId === undefined) offerId = value;
    else if (flag === "--duration" && duration === undefined) duration = value;
    else throw new UsageError("argument inconnu ou répété");
  }
  if (offerId === undefined || !UUID.test(offerId)) throw new UsageError("--offer doit être un UUID");
  if (duration === undefined || !(BOOST_DURATION_CODES as readonly string[]).includes(duration)) {
    throw new UsageError(`--duration doit valoir ${BOOST_DURATION_CODES.join(", ")}`);
  }
  return { offerId: offerId.toLowerCase(), durationCode: duration as BoostDurationCode };
}

async function main(): Promise<number> {
  const { offerId, durationCode } = parseArgs(process.argv.slice(2));
  requireDatabaseUrl();
  const pool = getPostgresPool();
  // Le propriétaire est celui de l'offre (l'administration n'attribue pas « au nom » d'un autre vendeur).
  const owner = await pool.query<{ owner_id: string }>("SELECT owner_id FROM offers WHERE id = $1::uuid", [offerId]);
  if (!owner.rows[0]) throw new BoostError("offer_not_found");
  const { boost, slots } = await grantOfferBoost({
    pool, offerId, ownerId: owner.rows[0].owner_id, durationCode, source: "admin_grant",
  });
  console.log(
    `Boost (administration) attribué : ${boost.id}, durée ${boost.durationCode}, jusqu'au ${boost.endsAt.toISOString()}. ` +
    `Places du périmètre : ${slots.used} utilisée(s) sur ${slots.total} (${slots.available} disponible(s)).`,
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
