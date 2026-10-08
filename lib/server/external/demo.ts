import "server-only";

import type { Pool } from "pg";
import { runCollectStep } from "./collect";
import { createFakeConnectors } from "./fake-connectors";
import { externalSchemaPresent } from "./registry";
import { readActiveDemandKeys, syncMarketWatches } from "./watches";

/**
 * Amorçage de démonstration de la collecte externe (lot EXT1), appelé par `npm run demo:seed` : synchronise les surveillances de marché, puis collecte, avec les deux connecteurs
 * FICTIFS, les surveillances des besoins de l'acheteur démo. Les VRAIS services sont utilisés (aucune écriture directe), donc l'amorçage est rejouable : un contenu déjà vu n'est ni
 * recréé ni réanalysé. Le quota et le budget du jour s'appliquent (au-delà, rien n'est collecté et le rapport l'indique). Aucun appel réseau.
 */

export interface ExternalDemoReport {
  /** Migration 0025 absente : rien fait. */
  skipped: boolean;
  /** Surveillances des besoins de l'acheteur démo. */
  watches: number;
  watchesCollected: number;
  listingsCreated: number;
  listingsKnown: number;
  sourceFailures: number;
  budgetSkipped: number;
}

export async function seedExternalDemo(pool: Pool, buyerId: string): Promise<ExternalDemoReport> {
  const report: ExternalDemoReport = { skipped: false, watches: 0, watchesCollected: 0, listingsCreated: 0, listingsKnown: 0, sourceFailures: 0, budgetSkipped: 0 };
  if (!(await externalSchemaPresent(pool))) return { ...report, skipped: true };
  await syncMarketWatches(pool, new Date());
  const keys = await readActiveDemandKeys(pool, buyerId);
  const found = await pool.query<{ id: string }>("SELECT id FROM market_watches WHERE status = 'active' AND product_key = ANY($1::text[]) ORDER BY product_key", [keys.map((entry) => entry.text)]);
  const ids = found.rows.map((row) => row.id);
  report.watches = ids.length;
  if (ids.length === 0) return report;
  const step = await runCollectStep({ pool, connectors: createFakeConnectors(), only: ids, maxWatches: ids.length, stepBudgetMs: 120_000 });
  if (step.errors.length > 0) throw new Error(`collecte externe de démonstration en échec (${step.errors.join(", ")})`);
  report.watchesCollected = step.watchesProcessed;
  report.listingsCreated = step.created;
  report.listingsKnown = step.unchanged + step.changed;
  report.sourceFailures = step.sourceFailures;
  report.budgetSkipped = step.budgetSkipped;
  return report;
}
