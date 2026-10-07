import { hostname } from "node:os";
import { getPostgresPool, closePostgresPool, requireDatabaseUrl } from "../lib/server/postgres/client";
import { requireWorkerId } from "../lib/server/matching/jobs";
import { runMatchingCycle, runMatchingWorkerLoop } from "../lib/server/matching/runner";

/** Worker du matching asynchrone. N'applique aucune migration et n'est jamais lancé par Next.js. */
function resolveWorkerId(): string {
  const configured = process.env.MATCHING_WORKER_ID?.trim();
  const raw = configured && configured.length > 0 ? configured : `${hostname()}-${process.pid}`;
  return requireWorkerId(raw);
}

async function main(): Promise<void> {
  requireDatabaseUrl();
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
    // Étape « notify » (lot N1) : une ligne seulement si elle a travaillé (jamais le contenu d'une notification ni un numéro).
    if (result.notify.users > 0 || result.notify.expired > 0) {
      console.log(
        `Matching worker : notifications, ${result.notify.messages} message(s) simulé(s) envoyé(s) (${result.notify.delivered} envoi(s)), ` +
        `${result.notify.skippedDeliveries} écarté(s), ${result.notify.deferred} reporté(s), ${result.notify.retried} à réessayer, ` +
        `${result.notify.failed} en échec, ${result.notify.expired} expiré(s).`,
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
        : (error instanceof Error && error.name === "DatabaseConfigurationError") || (error instanceof Error && error.name === "MatchingJobValidationError")
          ? `Matching worker : ${error.message}`
          : "Matching worker : erreur inattendue.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
