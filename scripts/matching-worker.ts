import { hostname } from "node:os";
import { assertSmsProductionConfig, smsStartupWarnings } from "../lib/server/sms/config";
import { getPostgresPool, closePostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";
import { requireWorkerId } from "../lib/server/matching/jobs";
import { runMatchingCycle, runMatchingWorkerLoop } from "../lib/server/matching/runner";
import { assertPaymentConfiguration } from "../lib/server/wallet/sublymus/config";
import { STARTUP_REFUSED_EXIT_CODE } from "../lib/server/startup-guard";

/** Worker du matching asynchrone. N'applique aucune migration et n'est jamais lancé par Next.js. */
function resolveWorkerId(): string {
  const configured = process.env.MATCHING_WORKER_ID?.trim();
  const raw = configured && configured.length > 0 ? configured : `${hostname()}-${process.pid}`;
  return requireWorkerId(raw);
}

async function main(): Promise<void> {
  // Lot SMS1 : en production, un fournisseur SMS mal configuré (meno sans clé valide…) interdit le démarrage du worker (il envoie les notifications).
  try {
    assertSmsProductionConfig(process.env);
  } catch (error) {
    // Message fixe qui nomme la variable, jamais sa valeur.
    console.error(`Matching worker : refus de démarrer : ${error instanceof Error ? error.message : "configuration SMS invalide"}.`);
    // Lot SMS1-ter : code de sortie DÉDIÉ au refus de démarrer (78), le même que celui du serveur (lib/server/startup-guard.ts).
    process.exitCode = STARTUP_REFUSED_EXIT_CODE;
    return;
  }
  for (const warning of smsStartupWarnings(process.env)) console.warn(warning);
  requireDatabaseUrl();
  // Lot PAY1 : comme le serveur, un worker mal configuré pour le paiement (rattrapage Sublymus) REFUSE de démarrer, avec un message clair (variables, jamais valeurs).
  try {
    assertPaymentConfiguration(process.env);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "PaymentConfigError") throw error;
    console.error(`Matching worker : ${error.message}`);
    process.exitCode = STARTUP_REFUSED_EXIT_CODE;
    return;
  }
  const workerId = resolveWorkerId();
  const once = process.argv.slice(2).includes("--once");
  const pool = getPostgresPool();

  if (once) {
    const result = await runMatchingCycle({ pool, workerId });
    console.log(
      `Matching worker : un cycle, ${result.temporal.expired} évaluation(s) périmée(s), ` +
      `${result.projected.selected} événement(s) lu(s), ` +
      `${result.maintenance.deadLettered} job(s) en dead_letter, ${result.jobs.length} job(s) exécuté(s).`,
    );
    if (result.boost.expired > 0) console.log(`Matching worker : ${result.boost.expired} boost(s) échu(s) marqué(s) expiré(s).`);
    // Étape « missions » (lot MV1) : une ligne seulement si elle a travaillé (jamais le contenu d'une mission).
    if (result.missions.expired > 0 || result.missions.changed > 0 || result.missions.notified > 0 || result.missions.released > 0) {
      console.log(
        `Matching worker : missions, ${result.missions.expired} échue(s), ${result.missions.evaluated} relue(s) (${result.missions.changed} couverture(s) modifiée(s)), ${result.missions.notified} notification(s), ${result.missions.released} besoin(s) porteur(s) libéré(s).`,
      );
    }
    // Étape « notify » (lot N1) : une ligne seulement si elle a travaillé (jamais le contenu d'une notification ni un numéro).
    if (result.notify.users > 0 || result.notify.expired > 0) {
      console.log(
        `Matching worker : notifications, ${result.notify.messages} message(s) simulé(s) envoyé(s) (${result.notify.delivered} envoi(s)), ` +
        `${result.notify.skippedDeliveries} écarté(s), ${result.notify.deferred} reporté(s), ${result.notify.retried} à réessayer, ` +
        `${result.notify.failed} en échec, ${result.notify.expired} expiré(s).`,
      );
    }
    // Étape « collect » (lot EXT1, sources FICTIVES) : une ligne seulement si elle a travaillé (jamais le contenu d'une annonce ni une adresse).
    if (result.collect.watchesProcessed > 0) {
      console.log(
        `Matching worker : collecte externe (sources fictives), ${result.collect.watchesProcessed} surveillance(s) collectée(s), ${result.collect.created} annonce(s) créée(s), ` +
        `${result.collect.sourceFailures} panne(s) de source.`,
      );
    }
    // Un code stable par ligne (jamais de message brut) ; une étape en échec donne le code de sortie 1.
    for (const code of result.errors) console.error(`Matching worker : ${code}`);
    if (result.errors.length > 0) process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.log("Matching worker démarré.");
  const result = await runMatchingWorkerLoop({ pool, workerId, signal: controller.signal });
  console.log(`Matching worker arrêté : ${result.cycles} cycle(s), ${result.jobsRun} job(s).`);
}

main()
  .catch((error: unknown) => {
    // Ni message ni charge utile : ils peuvent contenir hôte, identifiants ou requête.
    const code = (error as { code?: unknown } | null)?.code;
    console.error(
      typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)
        ? `Matching worker : erreur ${code}.`
        : (error instanceof Error && error.name === "DatabaseConfigurationError") || (error instanceof Error && error.name === "MatchingJobValidationError") || (error instanceof Error && error.name === "PaymentConfigError")
          ? `Matching worker : ${error.message}`
          : "Matching worker : erreur inattendue.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
