import "server-only";

import type { SqlExecutor } from "../postgres/client";
import { ALLOWED_SOURCE_TYPE } from "../external/config";
import { resolveConnectors } from "../external/registry";
import { readActiveSearchKeys } from "../external/watches";
import { acceleratedWatchLimit } from "./config";

/**
 * Disponibilité de la collecte externe et capacité de collecte accélérée (lot RA1-bis).
 *
 *  - `externalCollectionAvailable` : la collecte peut-elle fournir quelque chose ? Il faut au moins un CONNECTEUR résolu (`resolveConnectors` : aucun en production, aucun sans
 *    `NOMA_EXTERNAL_FAKE=1`) ET une SOURCE active qui lui correspond. Aujourd'hui, en production : jamais. `dev:try` active les connecteurs fictifs (démonstration) : l'option y est disponible.
 *  - `acceleratedCapacity` : combien de surveillances accélérées le quota des sources peut porter (`acceleratedWatchLimit` du plus petit quota des sources actives) et lesquelles sont déjà
 *    engagées (clés des besoins actifs qui ont une option en vigueur). Une clé déjà engagée n'ajoute rien (la surveillance est partagée) : ce contrôle d'admission ne refuse qu'une NOUVELLE clé.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

async function activeSourceQuotas(executor: SqlExecutor, env: Environment): Promise<number[]> {
  const connectors = resolveConnectors({ ...env });
  if (connectors.length === 0) return [];
  const rows = await executor.query<{ daily_quota: number }>(
    "SELECT daily_quota FROM external_sources WHERE enabled = TRUE AND type = $1 AND code = ANY($2::text[])",
    [ALLOWED_SOURCE_TYPE, connectors.map((connector) => connector.code)],
  );
  return rows.rows.map((row) => row.daily_quota);
}

export async function externalCollectionAvailable(executor: SqlExecutor, env: Environment): Promise<boolean> {
  return (await activeSourceQuotas(executor, env)).length > 0;
}

export interface AcceleratedCapacity {
  /** Surveillances accélérées que les quotas peuvent porter (0 si aucune source n'est active). */
  maxWatches: number;
  /** Clés produit déjà engagées par une option en vigueur. */
  keys: string[];
}

export async function acceleratedCapacity(executor: SqlExecutor, env: Environment, now: Date): Promise<AcceleratedCapacity> {
  const quotas = await activeSourceQuotas(executor, env);
  const keys = await readActiveSearchKeys(executor, now);
  return { maxWatches: quotas.length === 0 ? 0 : acceleratedWatchLimit(Math.min(...quotas)), keys };
}

/** Une clé déjà engagée est toujours admise (rien de plus à collecter) ; une NOUVELLE clé l'est seulement s'il reste de la capacité. */
export function capacityAllows(capacity: AcceleratedCapacity, keyText: string): boolean {
  return capacity.keys.includes(keyText) || capacity.keys.length < capacity.maxWatches;
}
