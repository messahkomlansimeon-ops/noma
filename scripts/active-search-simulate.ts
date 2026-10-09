import { simulateNewExternalListing } from "../lib/server/active-search/simulate";
import { closePostgresPool, getPostgresPool } from "../lib/server/postgres/client";
import { checkDemoSeedEnvironment } from "./demo-seed-plan";

/**
 * OUTIL DE DÉVELOPPEMENT (lot RA1) : fait apparaître une nouvelle annonce FICTIVE d'un autre site pour un besoin, puis collecte sa surveillance (connecteurs FICTIFS, aucun réseau) :
 * si le besoin a une recherche active en vigueur, l'acheteur est notifié. Mêmes garde-fous que `demo:seed` (base d'essai seulement : `noma_essai`, `noma_e2e`, `noma_essai_*` ; refus
 * pour `noma_dev`, `noma_test` et toute autre). Usage :
 *   npm run active-search:simulate -- --demand <uuid>
 * Code de sortie : 0 collecte faite, 1 refus ou erreur.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USAGE = "Usage : npm run active-search:simulate -- --demand <uuid> (DATABASE_URL doit désigner la base d'essai).";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--demand" || !UUID.test(args[1])) {
    console.error(`active-search:simulate : arguments invalides. ${USAGE}`);
    return 1;
  }
  const environment = checkDemoSeedEnvironment(process.env);
  if (!environment.ok) {
    console.error(`active-search:simulate : refus — ${environment.reason.replace(/demo:seed/g, "active-search:simulate")}`);
    return 1;
  }
  const result = await simulateNewExternalListing({ pool: getPostgresPool(), demandId: args[1].toLowerCase() });
  console.log(
    `active-search:simulate : annonce fictive « ${result.title} » (${result.priceAmount} XOF) ${result.created > 0 ? "créée" : "déjà connue"}, ` +
      `${result.notified} notification(s) d'annonce d'un autre site créée(s), ${result.sourceFailures} panne(s) de source${result.errors.length > 0 ? `, erreurs : ${result.errors.join(", ")}` : ""}.`,
  );
  return result.errors.length > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    console.error(`active-search:simulate : ${error instanceof Error && !("code" in error) ? error.message : "erreur inattendue"}.`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
