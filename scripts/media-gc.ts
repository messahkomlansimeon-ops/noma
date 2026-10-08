import { MEDIA_GC_MISSING_MAX_COUNT, MEDIA_GC_MISSING_MAX_PERCENT, MEDIA_GC_PRODUCTION_VARIABLE } from "../lib/server/media/config";
import { collectMediaGarbage, resolveMinAgeSeconds } from "../lib/server/media/gc";
import { createMediaStore } from "../lib/server/media/store";
import { purgeEnvironmentRefusal } from "../lib/server/metrics/purge";
import { closePostgresPool, getPostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";

/**
 * COMMANDE D'ADMINISTRATION (lot PH1) : purge des photos. Usage :
 *   npm run media:gc                    simulation : compte, ne supprime RIEN
 *   npm run media:gc -- --apply         supprime
 *   npm run media:gc -- --apply --expect-missing=<N>    supprime aussi N lignes sans fichier alors que c'est inhabituel (plus de 5 % des lignes, ou plus de 20) ; N doit être EXACTEMENT le nombre constaté
 * Supprime les fichiers du dossier NOMA_MEDIA_DIR (défaut data/media) qui n'ont plus de ligne en base (de plus de NOMA_MEDIA_GC_MIN_AGE_SECONDS secondes, défaut 600 ; seuls les noms
 * UUID et les fichiers temporaires de ce code sont touchés) et les lignes d'offer_photos dont le fichier a disparu. DATABASE_URL est obligatoire. Elle ne s'exécute que si NODE_ENV est
 * absent, « development » ou « test » (casse exacte) : toute autre valeur est refusée, simulation comprise ; en production (`NODE_ENV=production`) il faut en plus
 * `NOMA_MEDIA_GC_PRODUCTION=1`. `--apply` est REFUSÉ en entier (rien n'est supprimé) si plus de 5 % des lignes, ou plus de 20, n'ont pas de fichier : signe d'un NOMA_MEDIA_DIR mal
 * désigné. Code de sortie : 0 réussi, 1 refus ou erreur. Aucun message brut.
 */
const USAGE = "Usage : npm run media:gc [-- --apply [--expect-missing=<N>]]";

class UsageError extends Error {}
class RefusalError extends Error {}

function parseArgs(args: string[]): { apply: boolean; expectMissing: number | undefined } {
  if (args.length > 2 || new Set(args).size !== args.length) throw new UsageError("argument inconnu ou répété");
  let apply = false;
  let expectMissing: number | undefined;
  for (const arg of args) {
    if (arg === "--apply") apply = true;
    else if (/^--expect-missing=[0-9]{1,9}$/.test(arg)) expectMissing = Number(arg.slice("--expect-missing=".length));
    else throw new UsageError("argument inconnu ou répété");
  }
  if (expectMissing !== undefined && !apply) throw new UsageError("--expect-missing n'a de sens qu'avec --apply");
  return { apply, expectMissing };
}

async function main(): Promise<number> {
  const { apply, expectMissing } = parseArgs(process.argv.slice(2));
  const refusal = purgeEnvironmentRefusal(process.env, MEDIA_GC_PRODUCTION_VARIABLE);
  if (refusal !== null) throw new RefusalError(refusal);
  requireDatabaseUrl();
  const minAgeSeconds = resolveMinAgeSeconds(process.env);
  const result = await collectMediaGarbage({ pool: getPostgresPool(), store: createMediaStore(process.env), apply, minAgeSeconds, expectMissing });
  const { files, rows, journal } = result;
  const detail =
    `${files.scanned} fichier(s) lu(s) dont ${files.orphans} orphelin(s) et ${files.temporaries} temporaire(s) (${files.foreign} autre(s) fichier(s) ignoré(s)), ` +
    `${rows.scanned} ligne(s) lue(s) dont ${rows.withoutFile} sans fichier, ${journal.open} orphelin(s) journalisé(s)`;
  if (result.refusal === "too_many_missing") {
    console.error(
      `Photos : refus de supprimer : ${rows.withoutFile} ligne(s) sur ${rows.scanned} n'ont pas de fichier dans le dossier de stockage${result.storeExists ? "" : " (le dossier est introuvable)"} (plus de ${MEDIA_GC_MISSING_MAX_PERCENT} % des lignes, ou plus de ${MEDIA_GC_MISSING_MAX_COUNT}). ` +
        "C'est le signe d'un NOMA_MEDIA_DIR mal désigné (autre dossier, disque non monté, dossier vidé) : supprimer ces lignes effacerait des photos de vendeurs qui existent encore ailleurs, " +
        `et les fichiers d'une autre installation passeraient pour des orphelins. Vérifiez NOMA_MEDIA_DIR. Si ces fichiers sont réellement perdus, relancez avec --apply --expect-missing=${rows.withoutFile}. ` +
        (apply ? "Rien n'a été supprimé." : "(Simulation : --apply serait refusé.)"),
    );
  } else if (result.refusal === "expect_mismatch") {
    console.error(`Photos : refus de supprimer : --expect-missing=${expectMissing} ne correspond pas au nombre constaté (${rows.withoutFile} ligne(s) sans fichier sur ${rows.scanned}). ${apply ? "Rien n'a été supprimé." : ""}`);
  }
  if (apply && result.refusal === null) console.log(`Photos : ${detail} ; ${files.deleted} fichier(s) et ${rows.deleted} ligne(s) supprimé(s), ${journal.resolved} entrée(s) du journal résolue(s).`);
  else if (!apply) console.log(`Photos : simulation, ${detail}. Rien n'a été supprimé : relancez avec --apply pour supprimer.`);
  else console.log(`Photos : ${detail}.`);
  return apply && result.refusal !== null ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof UsageError) console.error(`Photos : ${error.message}. ${USAGE}`);
    else if (error instanceof RefusalError) console.error(`Photos : ${error.message}`);
    else if (error instanceof RangeError) console.error(`Photos : ${error.message}`);
    else if (error instanceof Error && error.name === "DatabaseConfigurationError") console.error(`Photos : ${error.message}`);
    else if (error instanceof Error && error.name === "MediaError") console.error("Photos : dossier de stockage inutilisable (NOMA_MEDIA_DIR).");
    else if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) console.error(`Photos : erreur ${code}.`);
    else console.error("Photos : erreur inattendue.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
