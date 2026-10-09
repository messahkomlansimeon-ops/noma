import "server-only";

import type { Pool } from "pg";
import { scanActiveSearchDemands } from "./notify";
import { runActiveSearchMaintenance } from "./maintenance";
import { activeSearchSchemaPresent } from "./state";

/**
 * Étape « activeSearch » du worker (lot RA1), exécutée APRÈS « collect » dans un `try` qui lui est propre (voir `matching/runner.ts`) : une panne ici n'arrête aucune autre étape, et une
 * panne de la collecte n'empêche pas l'entretien. Deux temps, chacun isolé :
 *  1. entretien (instructions uniques, idempotentes) : fins de période, arrêts (besoin archivé, sans remboursement ; un besoin satisfait SUSPEND l'option sans l'arrêter), retour du suivi à 90 jours, avis d'échéance ;
 *  2. balayage des annonces d'autres sites pour les besoins qui ont une option en vigueur : relevé de l'existant, notifications des annonces NOUVELLES (voir notify.ts).
 * La fréquence accélérée de la collecte (1 h, 24 requêtes par jour et par source) n'est PAS réglée ici mais par la synchronisation des surveillances de l'étape « collect »
 * (`syncMarketWatches`). Budget : 3 s de balayage et 25 besoins au plus par passage ; l'étape n'allonge donc le cycle que de quelques secondes. Sans la migration 0028, ignorée sans erreur.
 */

export interface ActiveSearchStepResult {
  /** Migration 0028 absente : étape ignorée sans erreur. */
  skipped: boolean;
  ended: number;
  stopped: number;
  trackingClamped: number;
  notices: number;
  /** Besoins avec une option en vigueur examinés, notifications créées, annonces résumées, listes d'annonces existantes relevées, envois externes simulés créés. */
  examined: number;
  notified: number;
  digested: number;
  baselines: number;
  deliveries: number;
  trackingHeld: number;
  /** Besoins laissés au passage suivant (budget de temps ou nombre maximal) ou dont un verrou était tenu par un autre processus. */
  deferred: number;
  busy: number;
  /** Codes stables des erreurs de l'étape (jamais un message). */
  errors: string[];
}

export function emptyActiveSearchStepResult(): ActiveSearchStepResult {
  return { skipped: false, ended: 0, stopped: 0, trackingClamped: 0, notices: 0, examined: 0, notified: 0, digested: 0, baselines: 0, deliveries: 0, trackingHeld: 0, deferred: 0, busy: 0, errors: [] };
}

/** Travail effectué (de quoi relancer la boucle sans pause) : une fin, un arrêt, un avis, une notification ou un relevé. Un simple examen sans effet ne compte pas. */
export function activeSearchWork(result: ActiveSearchStepResult): number {
  return result.ended + result.stopped + result.trackingClamped + result.notices + result.notified + result.digested + result.baselines;
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code.toLowerCase() : "unknown";
}

export interface ActiveSearchStepOptions {
  pool: Pool;
  /** Horloge injectable (essais, outils) ; défaut : l'heure du processus. */
  now?: () => Date;
  budgetMs?: number;
  maxDemands?: number;
}

/** Ne lève jamais : les erreurs sont des codes stables dans `errors` (`maintenance_<code>`, `scan_<code>`). */
export async function runActiveSearchStep(options: ActiveSearchStepOptions): Promise<ActiveSearchStepResult> {
  const result = emptyActiveSearchStepResult();
  const clock = options.now ?? (() => new Date());
  try {
    if (!(await activeSearchSchemaPresent(options.pool))) return { ...result, skipped: true };
  } catch (error) {
    result.errors.push(`schema_${errorCodeOf(error)}`);
    return result;
  }
  try {
    // Instructions uniques sur le pool, sans attente de verrou (SKIP LOCKED) : aucune connexion dédiée n'est ouverte pour l'entretien.
    const maintenance = await runActiveSearchMaintenance(options.pool, clock());
    result.ended = maintenance.ended;
    result.stopped = maintenance.stopped;
    result.trackingClamped = maintenance.trackingClamped;
    result.notices = maintenance.notices;
  } catch (error) {
    result.errors.push(`maintenance_${errorCodeOf(error)}`);
  }
  try {
    const scan = await scanActiveSearchDemands({ pool: options.pool, now: clock(), budgetMs: options.budgetMs, maxDemands: options.maxDemands });
    result.examined = scan.examined;
    result.notified = scan.notified;
    result.digested = scan.digested;
    result.baselines = scan.baselines;
    result.deliveries = scan.deliveries;
    result.trackingHeld = scan.trackingHeld;
    result.deferred = scan.deferred;
    result.busy += scan.busy;
    for (const code of scan.errors) result.errors.push(`scan_${code}`);
  } catch (error) {
    result.errors.push(`scan_${errorCodeOf(error)}`);
  }
  return result;
}
