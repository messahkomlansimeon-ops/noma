import { Pool } from "pg";
import { requireDatabaseUrl } from "../lib/server/postgres/client";
import { readMatchingStatus, type MatchingStatusReport } from "../lib/server/matching/status";

/**
 * État de santé du matching (lecture seule). Code de sortie : 0 sain, 2 avertissements, 1 erreur.
 * Aucun message brut : ni requête, ni identifiant, ni texte de la base.
 */
function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length === 0 ? "aucun" : entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

function formatReport(report: MatchingStatusReport): string[] {
  const lines = [`Matching status (lu le ${report.readAt})`];
  if (!report.schemaReady) {
    lines.push("Schéma : NON PRÊT (migration 0010_matching_job_leases absente)");
  } else {
    lines.push(`Schéma : prêt (${report.migrations.count} migration(s), dernière ${report.migrations.latest})`);
    lines.push(`Événements pending : ${formatCounts(report.outbox.pendingByType)}`);
    lines.push(`Événements projected : ${formatCounts(report.outbox.projectedByType)}`);
    lines.push(report.outbox.oldestPending
      ? `Plus ancien pending : ${report.outbox.oldestPending.eventType}, ${report.outbox.oldestPending.ageSeconds} s`
      : "Plus ancien pending : aucun");
    lines.push(`Événements ignored (par code) : ${formatCounts(report.outbox.ignoredByCode)}`);
    lines.push(`Jobs (type/statut) : ${report.jobs.byTypeAndStatus.length === 0
      ? "aucun"
      : report.jobs.byTypeAndStatus.map((row) => `${row.jobType}/${row.status}=${row.count}`).join(", ")}`);
    lines.push(`Jobs running à bail expiré : ${report.jobs.runningWithExpiredLease}`);
    lines.push(`dead_letter : ${report.jobs.deadLetter.count} (codes : ${formatCounts(report.jobs.deadLetter.byErrorCode)})`);
    lines.push(`Évaluations actives : ${report.evaluations.active}, dont expirées : ${report.evaluations.activeExpired}`);
    lines.push(`Dernier job completed : ${report.jobs.lastCompletedAt ?? "aucun"}`);
    lines.push(`Boosts : ${report.boosts.effective} effectif(s), ${report.boosts.overdue} en retard d'expiration`);
  }
  if (report.warnings.length === 0) lines.push("Avertissements : aucun");
  else {
    lines.push("Avertissements :");
    for (const warning of report.warnings) lines.push(`  - ${warning.code} : ${warning.message}`);
  }
  return lines;
}

function describeFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return `Matching status : erreur ${code}.`;
  if (error instanceof Error && error.name === "DatabaseConfigurationError") return `Matching status : ${error.message}`;
  return "Matching status : erreur inattendue.";
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    console.error("Matching status : argument inconnu (seul --json est accepté).");
    return 1;
  }
  const connectionString = requireDatabaseUrl();
  // Session elle-même en lecture seule, en plus de la transaction READ ONLY ; PGOPTIONS (ex. search_path) est conservé.
  const options = `${process.env.PGOPTIONS ?? ""} -c default_transaction_read_only=on`.trim();
  const pool = new Pool({ connectionString, max: 1, options });
  try {
    const report = await readMatchingStatus({ pool });
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else for (const line of formatReport(report)) console.log(line);
    return report.warnings.length > 0 ? 2 : 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    console.error(describeFailure(error));
    process.exitCode = 1;
  });
